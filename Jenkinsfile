pipeline {
    agent any

    stages {
        stage('Build') {
            steps {
                script {
                    echo 'Building the Company OS dashboard...'
                    sh 'npm install'
                    sh 'npm run build'
                }
            }
        }
        stage('Deploy') {
            steps {
                script {
                    echo 'Deploying to production...'
                    // This step will be handled by the Jenkins server configuration,
                    // which should be set up to serve the 'dist' directory.
                    // For now, we just archive the artifacts.
                    archiveArtifacts artifacts: 'dist/**/*', followSymlinks: false
                }
            }
        }
    }

    post {
        always {
            echo 'Pipeline finished.'
        }
    }
}
